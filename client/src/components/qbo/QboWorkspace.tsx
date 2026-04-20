import { getBaseUrl } from "../../lib/apiConfig";
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowRightLeft,
  CheckCircle2,
  Link2,
  RefreshCw,
  Table2,
} from "lucide-react";
import QboMappingMatrix from "./QboMappingMatrix";
import {
  type AccountMapping,
  buildMatrixInitialFromGranular,
  matrixKeyToGranular,
  QBO_MATRIX_TENDERS,
} from "./QboMappingLogic";
import { useToast } from "../ui/ToastProviderLogic";
import ConfirmationModal from "../ui/ConfirmationModal";
import { useShellBackdropLayer } from "../layout/ShellBackdropContextLogic";
import { useDialogAccessibility } from "../../hooks/useDialogAccessibility";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { formatUsdFromCents, parseMoneyToCents } from "../../lib/money";

const baseUrl = getBaseUrl();

type Tab = "connection" | "mappings" | "staging" | "history";

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

interface CredentialsPublic {
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

interface SyncLogRow {
  id: string;
  sync_date: string;
  journal_entry_id: string | null;
  status: string;
  payload: Record<string, unknown>;
  error_message: string | null;
  created_at: string;
}

interface StagingDrilldown {
  line_index: number;
  memo: string;
  contributors: { order_id: string; amount: string }[];
}

interface AccessLogRow {
  id: string;
  staff_id: string;
  staff_name: string;
  staff_avatar_key?: string;
  event_kind: string;
  metadata: Record<string, unknown>;
  created_at: string;
}

type ConfirmAction =
  | { kind: "approve"; id: string; label: string }
  | { kind: "sync"; id: string; label: string }
  | null;

const LEGACY_ROWS: { key: string; description: string }[] = [
  { key: "REVENUE_CLOTHING", description: "Fallback revenue (unmapped category)" },
  { key: "REVENUE_FOOTWEAR", description: "Footwear revenue fallback" },
  { key: "REVENUE_SERVICE", description: "Service / alterations fallback" },
  { key: "INV_ASSET", description: "Default inventory asset" },
  { key: "COGS_DEFAULT", description: "Default COGS" },
  { key: "COGS_FREIGHT", description: "Inbound freight (PO)" },
  { key: "EXP_SHIPPING", description: "Shipping expense" },
  { key: "EXP_MERCHANT_FEE", description: "Stripe / Card processing fees" },
];

function moneyJson(n: unknown): string {
  if (n == null) return "0";
  const s = String(n).trim();
  if (!s) return "0";
  if (!Number.isFinite(Number.parseFloat(s))) return String(n);
  return formatUsdFromCents(parseMoneyToCents(s));
}

interface QboWorkspaceProps {
  activeSection?: string;
  deepLinkSyncLogId?: string | null;
  onDeepLinkSyncLogConsumed?: () => void;
}

export default function QboWorkspace({
  activeSection,
  deepLinkSyncLogId,
  onDeepLinkSyncLogConsumed,
}: QboWorkspaceProps) {
  const [tab, setTab] = useState<Tab>("connection");

  useEffect(() => {
    const map: Record<string, Tab> = {
      connection: "connection",
      mappings: "mappings",
      staging: "staging",
      history: "staging", // history is rendered within the staging panel
    };
    if (activeSection && map[activeSection]) setTab(map[activeSection]);
  }, [activeSection]);

  useEffect(() => {
    const id = deepLinkSyncLogId?.trim();
    if (!id) return;
    setTab("staging");
    setExpandedId(id);
    onDeepLinkSyncLogConsumed?.();
  }, [deepLinkSyncLogId, onDeepLinkSyncLogConsumed]);
  const [accounts, setAccounts] = useState<QboAccount[]>([]);
  const [categories, setCategories] = useState<CategoryRow[]>([]);
  const [granular, setGranular] = useState<GranularMapping[]>([]);
  const [ledger, setLedger] = useState<LedgerMapping[]>([]);
  const [creds, setCreds] = useState<CredentialsPublic | null>(null);
  const [staging, setStaging] = useState<SyncLogRow[]>([]);
  const [busy, setBusy] = useState(false);
  const { toast } = useToast();

  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [realmId, setRealmId] = useState("");
  const [useSandbox, setUseSandbox] = useState(true);

  const [proposeDate, setProposeDate] = useState(() =>
    new Date().toISOString().slice(0, 10),
  );
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [drilldown, setDrilldown] = useState<StagingDrilldown | null>(null);
  const [accessLog, setAccessLog] = useState<AccessLogRow[]>([]);
  const [confirmAction, setConfirmAction] = useState<ConfirmAction>(null);

  const drillOpen = drilldown !== null;
  useShellBackdropLayer(drillOpen);
  const { dialogRef: drillDialogRef, titleId: drillTitleId } = useDialogAccessibility(drillOpen, {
    onEscape: () => setDrilldown(null),
  });

  const { backofficeHeaders, staffCode } = useBackofficeAuth();

  const accountNameById = useMemo(
    () => new Map(accounts.map((a) => [a.id, a.name])),
    [accounts],
  );

  const initialMatrixMappings = useMemo(
    () => buildMatrixInitialFromGranular(granular),
    [granular],
  );

  const refreshCore = useCallback(async () => {
    const h = backofficeHeaders();
    const [a, c, g, l, cr, st] = await Promise.all([
      fetch(`${baseUrl}/api/qbo/accounts-cache`, { headers: h }),
      fetch(`${baseUrl}/api/categories`, { headers: h }),
      fetch(`${baseUrl}/api/qbo/granular-mappings`, { headers: h }),
      fetch(`${baseUrl}/api/qbo/mappings`, { headers: h }),
      fetch(`${baseUrl}/api/qbo/credentials`, { headers: h }),
      fetch(`${baseUrl}/api/qbo/staging`, { headers: h }),
    ]);
    if (a.ok) setAccounts((await a.json()) as QboAccount[]);
    if (c.ok) setCategories((await c.json()) as CategoryRow[]);
    if (g.ok) setGranular((await g.json()) as GranularMapping[]);
    if (l.ok) setLedger((await l.json()) as LedgerMapping[]);
    if (cr.ok) {
      const pub = (await cr.json()) as CredentialsPublic;
      setCreds(pub);
      setRealmId(pub.realm_id ?? "");
      setUseSandbox(pub.use_sandbox);
    }
    if (st.ok) setStaging((await st.json()) as SyncLogRow[]);
  }, [backofficeHeaders]);

  useEffect(() => {
    void refreshCore();
  }, [refreshCore]);

  useEffect(() => {
    const loadAccess = async () => {
      if (!staffCode.trim()) {
        setAccessLog([]);
        return;
      }
      const res = await fetch(`${baseUrl}/api/staff/admin/access-log?limit=600`, {
        headers: backofficeHeaders(),
      });
      if (!res.ok) {
        setAccessLog([]);
        return;
      }
      const rows = (await res.json()) as AccessLogRow[];
      const qboRows = rows.filter((r) => r.event_kind.startsWith("qbo_"));
      setAccessLog(qboRows);
    };
    void loadAccess();
  }, [staffCode, staging.length, backofficeHeaders]);

  const connectionReady = useMemo(
    () =>
      !!creds &&
      !!creds.realm_id &&
      creds.client_id_set &&
      creds.has_client_secret,
    [creds],
  );
  const mappingsReady = useMemo(
    () =>
      granular.length > 0 || ledger.some((row) => !!row.qbo_account_id?.trim()),
    [granular.length, ledger],
  );

  const refreshAccountsOnly = async () => {
    setBusy(true);
    try {
      await fetch(`${baseUrl}/api/qbo/accounts-cache/refresh`, {
        method: "POST",
        headers: backofficeHeaders(),
      });
      await refreshCore();
      toast("Account cache refreshed.", "success");
    } catch {
      toast("Refresh failed.", "error");
    } finally {
      setBusy(false);
    }
  };

  const saveCredentials = async () => {
    setBusy(true);
    try {
      const res = await fetch(`${baseUrl}/api/qbo/credentials`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          ...(backofficeHeaders() as Record<string, string>),
        },
        body: JSON.stringify({
          client_id: clientId.trim() || null,
          client_secret: clientSecret.trim() || null,
          realm_id: realmId.trim() || null,
          use_sandbox: useSandbox,
        }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? "Save failed");
      }
      setClientSecret("");
      setClientId("");
      await refreshCore();
      toast("Credentials saved.", "success");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Save failed", "error");
    } finally {
      setBusy(false);
    }
  };

  const refreshTokens = async () => {
    setBusy(true);
    try {
      const res = await fetch(`${baseUrl}/api/qbo/tokens/refresh`, {
        method: "POST",
        headers: backofficeHeaders(),
      });
      const j = (await res.json().catch(() => ({}))) as {
        error?: string;
        note?: string;
      };
      if (!res.ok) throw new Error(j.error ?? "Refresh failed");
      await refreshCore();
      toast(j.note ?? "Token refresh completed.", "success");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Refresh failed", "error");
    } finally {
      setBusy(false);
    }
  };

  const saveMatrixMappings = async (m: Record<string, AccountMapping>) => {
    const errors: string[] = [];
    await Promise.all(
      Object.values(m).map(async (val) => {
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
    );
    if (errors.length > 0) {
      toast(errors[0] ?? "Save failed", "error");
      return;
    }
    await refreshCore();
    toast("Mapping matrix saved.", "success");
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
      throw new Error(j.error ?? "Save failed");
    }
    await refreshCore();
  };

  const proposeJournal = async () => {
    setBusy(true);
    try {
      const res = await fetch(`${baseUrl}/api/qbo/staging/propose`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(backofficeHeaders() as Record<string, string>),
        },
        body: JSON.stringify({ activity_date: proposeDate }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? "Propose failed");
      }
      await refreshCore();
      toast("Journal proposal created or returned existing pending.", "success");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Propose failed", "error");
    } finally {
      setBusy(false);
    }
  };

  const approveRow = async (id: string) => {
    setBusy(true);
    try {
      const res = await fetch(
        `${baseUrl}/api/qbo/staging/${encodeURIComponent(id)}/approve`,
        { method: "POST", headers: backofficeHeaders() },
      );
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? "Approve failed");
      }
      await refreshCore();
      toast("Marked approved.", "success");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Approve failed", "error");
    } finally {
      setBusy(false);
    }
  };

  const syncRow = async (id: string) => {
    setBusy(true);
    try {
      const res = await fetch(
        `${baseUrl}/api/qbo/staging/${encodeURIComponent(id)}/sync`,
        { method: "POST", headers: backofficeHeaders() },
      );
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? "Sync failed");
      }
      const data = (await res.json()) as { journal_entry_id?: string };
      await refreshCore();
      toast(
        data.journal_entry_id
          ? `Synced (simulated): ${data.journal_entry_id}`
          : "Synced.",
        "success"
      );
    } catch (e) {
      toast(e instanceof Error ? e.message : "Sync failed", "error");
    } finally {
      setBusy(false);
    }
  };

  const runConfirmedAction = async () => {
    if (!confirmAction) return;
    if (confirmAction.kind === "approve") {
      await approveRow(confirmAction.id);
    } else if (confirmAction.kind === "sync") {
      await syncRow(confirmAction.id);
    }
    setConfirmAction(null);
  };

  const loadDrilldown = async (id: string, lineIndex: number) => {
    try {
      const res = await fetch(
        `${baseUrl}/api/qbo/staging/${encodeURIComponent(id)}/drilldown?line_index=${lineIndex}`,
        { headers: backofficeHeaders() },
      );
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        line_index?: number;
        memo?: string;
        contributors?: { order_id: string; amount: string }[];
      };
      if (!res.ok) throw new Error(body.error ?? "Drill-down failed");
      setDrilldown({
        line_index: body.line_index ?? lineIndex,
        memo: body.memo ?? "Journal line",
        contributors: body.contributors ?? [],
      });
    } catch (e) {
      toast(e instanceof Error ? e.message : "Drill-down failed", "error");
    }
  };

  const tabBtn = (id: Tab, label: string, Icon: typeof Link2) => (
    <button
      key={id}
      type="button"
      onClick={() => setTab(id)}
      className={`flex min-h-[44px] items-center gap-2 rounded-xl px-4 py-2.5 text-[10px] font-black uppercase tracking-widest transition-colors ${
        tab === id
          ? "bg-app-accent text-white shadow-sm"
          : "border border-app-border bg-app-surface text-app-text-muted hover:bg-app-surface-2"
      }`}
    >
      <Icon size={15} aria-hidden />
      {label}
    </button>
  );

  return (
    <div className="ui-page overflow-auto">
      <div className="flex items-center justify-between px-1 pb-2">
        <div>
          <p className="text-[10px] font-black uppercase tracking-[0.16em] text-app-text-muted">QBO Bridge</p>
          <h2 className="text-2xl font-black tracking-tight text-app-text">
            {tab === "connection" ? "Connection" : tab === "mappings" ? "Account Mappings" : "Staging & History"}
          </h2>
        </div>
        <div className="flex flex-wrap gap-2">
          {tabBtn("connection", "1 · Connection", Link2)}
          {tabBtn("mappings", "2 · Mappings", Table2)}
          {tabBtn("staging", "3 · Staging", ArrowRightLeft)}
        </div>
      </div>

      <div className="ui-card bg-app-surface-2 px-5 py-4">
        <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
          Workflow: Connection → Mappings → Staging
        </p>
        <div className="mt-2 flex flex-wrap gap-2 text-[10px] font-bold uppercase tracking-widest">
          <span
            className={`rounded-full px-2 py-1 ${
              connectionReady
                ? "bg-emerald-100 text-emerald-800"
                : "bg-amber-100 text-amber-800"
            }`}
          >
            1 Connection {connectionReady ? "ready" : "pending"}
          </span>
          <span
            className={`rounded-full px-2 py-1 ${
              mappingsReady
                ? "bg-emerald-100 text-emerald-800"
                : "bg-amber-100 text-amber-800"
            }`}
          >
            2 Mappings {mappingsReady ? "ready" : "pending"}
          </span>
            <span className="rounded-full bg-app-surface px-2 py-1 text-app-text-muted">
            3 Stage + approve + sync
          </span>
        </div>
      </div>
      <div className="ui-card bg-[linear-gradient(145deg,color-mix(in_srgb,var(--app-accent)_14%,var(--app-surface-2)),color-mix(in_srgb,var(--app-accent-2)_12%,var(--app-surface-2)))] px-5 py-4">
        <p className="text-[10px] font-black uppercase tracking-[0.16em] text-app-text-muted">
          Financial bridge panel
        </p>
        <p className="mt-1 text-sm font-semibold text-app-text">
          Use highlighted workflow states to ensure mapping completeness before syncing journals.
        </p>
      </div>

      <div className="ui-card bg-[color-mix(in_srgb,var(--app-accent-2)_10%,var(--app-surface-2))] px-5 py-4">
        <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
          Staff session
        </p>
        <p className="mt-1 text-xs text-app-text-muted">
          QBO API calls use your Back Office staff credentials (unlock Staff, or the
          cashier code from an open register session when you are in Back Office).
        </p>
      </div>

      {tab === "connection" ? (
        <div className="ui-section-stack">
          <div className="ui-card p-6">
            <h3 className="text-sm font-black uppercase tracking-widest text-app-text-muted">
              Developer credentials
            </h3>
            <p className="mt-2 text-xs text-app-text-muted">
              OAuth client from Intuit Developer. Secrets are stored server-side
              (encrypt in production). Realm ID is your QBO company id.
            </p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void saveCredentials();
              }}
              className="mt-4 space-y-3"
            >
              <label className="block text-[10px] font-black uppercase text-app-text-muted">
                Realm ID (company)
                <input
                  value={realmId}
                  onChange={(e) => setRealmId(e.target.value)}
                  className="ui-input mt-1 w-full font-mono text-sm"
                />
              </label>
              <label className="block text-[10px] font-black uppercase text-app-text-muted">
                Client ID
                <input
                  value={clientId}
                  onChange={(e) => setClientId(e.target.value)}
                  placeholder={
                    creds?.client_id_set
                      ? `Saved (${creds?.client_id_masked ?? "set"})`
                      : ""
                  }
                  className="ui-input mt-1 w-full font-mono text-sm"
                />
              </label>
              <label className="block text-[10px] font-black uppercase text-app-text-muted">
                Client secret
                <input
                  type="password"
                  value={clientSecret}
                  onChange={(e) => setClientSecret(e.target.value)}
                  placeholder={creds?.has_client_secret ? "•••••••• (saved)" : ""}
                  className="ui-input mt-1 w-full font-mono text-sm"
                />
              </label>
              <label className="flex items-center gap-2 text-sm font-semibold text-app-text">
                <input
                  type="checkbox"
                  checked={useSandbox}
                  onChange={(e) => setUseSandbox(e.target.checked)}
                />
                Sandbox environment
              </label>
              <button
                type="submit"
                disabled={busy}
                className="ui-btn-primary mt-5 w-full rounded-2xl py-3 disabled:opacity-50"
              >
                Save connection
              </button>
            </form>
            <button
              type="button"
              disabled={!connectionReady}
              onClick={() => setTab("mappings")}
              className="ui-btn-secondary mt-2 w-full rounded-2xl py-3"
            >
              Continue to mappings
            </button>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="ui-card p-6">
              <h3 className="text-sm font-black uppercase tracking-widest text-app-text-muted">
                Token lifecycle
              </h3>
              <p className="mt-2 text-xs text-app-text-muted">
                After OAuth authorization stores a refresh token, this extends the
                local expiry placeholder. Full Intuit token exchange ships next.
              </p>
              <p className="mt-3 font-mono text-xs text-app-text">
                Refresh token:{" "}
                {creds?.has_refresh_token ? "present" : "not set"}
                <br />
                Expires: {creds?.token_expires_at ?? "—"}
              </p>
              <button
                type="button"
                disabled={busy}
                onClick={() => void refreshTokens()}
                className="ui-btn-secondary mt-4 w-full py-3 disabled:opacity-50"
              >
                Refresh access token (stub)
              </button>
            </div>
            <div className="flex items-center gap-2 rounded-xl border border-app-border bg-[color-mix(in_srgb,var(--app-accent)_12%,var(--app-surface-2))] px-4 py-3">
              <CheckCircle2 className="text-emerald-600" size={18} />
              <span className="text-xs font-bold text-app-text">
                Integration row {creds?.is_active ? "active" : "inactive"}
              </span>
            </div>
          </div>
        </div>
      ) : null}

      {tab === "mappings" ? (
        <div className="flex flex-col gap-8">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-app-border bg-[color-mix(in_srgb,var(--app-accent)_10%,var(--app-surface-2))] p-3">
            <h3 className="text-sm font-black uppercase tracking-widest text-app-text-muted">
              Chart of accounts cache
            </h3>
            <button
              type="button"
              disabled={busy}
              onClick={() => void refreshAccountsOnly()}
              className="ui-btn-primary flex items-center gap-2"
            >
              <RefreshCw size={14} /> Refresh QBO accounts (demo list)
            </button>
          </div>

          <QboMappingMatrix
            categories={categories}
            tenders={QBO_MATRIX_TENDERS}
            accounts={accounts}
            initialMappings={initialMatrixMappings}
            onSave={async (m: Record<string, AccountMapping>) => {
              try {
                await saveMatrixMappings(m);
              } catch (e) {
                toast(e instanceof Error ? e.message : "Save failed", "error");
                throw e;
              }
            }}
          />

          <div className="overflow-hidden rounded-2xl border border-app-border bg-app-surface-2 shadow-sm">
            <div className="border-b border-app-border px-4 py-2 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
              Global fallbacks (<span className="font-mono">ledger_mappings</span>)
            </div>
            <table className="w-full text-left text-sm">
              <thead className="bg-app-surface text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                <tr>
                  <th className="px-4 py-2">Key</th>
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
                        <div className="font-mono text-xs font-bold">{row.key}</div>
                        <p className="text-[10px] text-app-text-muted">{row.description}</p>
                      </td>
                      <td className="px-4 py-2">
                        <select
                          value={val}
                          onChange={(e) => {
                            const v = e.target.value;
                            if (!v) return;
                            void saveLegacy(row.key, v).catch((ex) =>
                              toast(
                                ex instanceof Error ? ex.message : "Save failed",
                                "error"
                              ),
                            );
                          }}
                          className="w-full max-w-xs rounded-lg border border-app-border bg-app-surface-2 py-1.5 pl-2 text-xs font-semibold"
                        >
                          <option value="">Select…</option>
                          {accounts.map((a) => (
                            <option key={a.id} value={a.id}>
                              {a.name}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="px-4 py-2 text-right text-[10px] text-app-text-muted">
                        {val ? accountNameById.get(val) : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="flex justify-end">
            <button
              type="button"
              disabled={!mappingsReady}
              onClick={() => setTab("staging")}
              className="rounded-xl bg-app-accent px-5 py-2.5 text-[10px] font-black uppercase tracking-widest text-white disabled:opacity-50"
            >
              Continue to staging
            </button>
          </div>
        </div>
      ) : null}

      {tab === "staging" ? (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-end gap-3 rounded-2xl border border-app-border bg-app-surface-2/80 p-4">
            <label className="text-[10px] font-black uppercase text-app-text-muted">
              Activity date (UTC)
              <input
                type="date"
                value={proposeDate}
                onChange={(e) => setProposeDate(e.target.value)}
                className="ui-input mt-1 block text-sm"
              />
            </label>
            <button
              type="button"
              disabled={busy}
              onClick={() => void proposeJournal()}
              className="ui-btn-primary px-5 py-2.5 disabled:opacity-50"
            >
              Propose journal
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void refreshCore()}
              className="ui-btn-secondary px-5 py-2.5"
            >
              Reload queue
            </button>
          </div>

          <div className="overflow-hidden rounded-2xl border border-app-border bg-app-surface">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-app-border bg-app-surface-2 text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                <tr>
                  <th className="px-4 py-3">Date</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Balance</th>
                  <th className="px-4 py-3">QBO JE</th>
                  <th className="px-4 py-3">Fault</th>
                  <th className="px-4 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-app-border">
                {staging.map((r) => {
                  const p = r.payload as {
                    totals?: { debits?: string; credits?: string; balanced?: boolean };
                    lines?: { debit: string; credit: string; memo: string }[];
                  };
                  const bal = p.totals?.balanced ? "Yes" : "No";
                  return (
                    <Fragment key={r.id}>
                      <tr className="hover:bg-app-surface-2/80">
                        <td className="px-4 py-3 font-mono text-xs">{r.sync_date}</td>
                        <td className="px-4 py-3">
                          <span
                            className={`rounded-full px-2 py-0.5 text-[9px] font-black uppercase ${
                              r.status === "synced"
                                ? "bg-emerald-100 text-emerald-800"
                                : r.status === "approved"
                                  ? "bg-blue-100 text-blue-800"
                                  : r.status === "pending"
                                    ? "bg-amber-100 text-amber-900"
                                    : "bg-app-surface-2 text-app-text-muted"
                            }`}
                          >
                            {r.status}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-xs">
                          DR {moneyJson(p.totals?.debits)} / CR{" "}
                          {moneyJson(p.totals?.credits)} · {bal}
                        </td>
                        <td className="px-4 py-3 font-mono text-xs">
                          {r.journal_entry_id ?? "—"}
                        </td>
                        <td className="px-4 py-3 text-xs">
                          {r.error_message ? (
                            <span className="rounded bg-red-50 px-2 py-1 font-semibold text-red-700">
                              {r.error_message}
                            </span>
                          ) : (
                            "—"
                          )}
                        </td>
                        <td className="px-4 py-3 text-right">
                          <button
                            type="button"
                            className="mr-2 text-[10px] font-black uppercase text-violet-700"
                            onClick={() =>
                              setExpandedId((x) => (x === r.id ? null : r.id))
                            }
                          >
                            {expandedId === r.id ? "Hide" : "Lines"}
                          </button>
                          {r.status === "pending" ? (
                            <button
                              type="button"
                              disabled={busy}
                              className="mr-2 text-[10px] font-black uppercase text-blue-700"
                              onClick={() =>
                                setConfirmAction({
                                  kind: "approve",
                                  id: r.id,
                                  label: `Approve staged journal ${r.sync_date}?`,
                                })
                              }
                            >
                              Approve
                            </button>
                          ) : null}
                          {r.status === "approved" ? (
                            <button
                              type="button"
                              disabled={busy}
                              className="text-[10px] font-black uppercase text-emerald-700"
                              onClick={() =>
                                setConfirmAction({
                                  kind: "sync",
                                  id: r.id,
                                  label:
                                    "Send this approved journal to QuickBooks now?",
                                })
                              }
                            >
                              Send to QBO
                            </button>
                          ) : null}
                        </td>
                      </tr>
                      {expandedId === r.id ? (
                        <tr>
                          <td colSpan={6} className="bg-app-text px-4 py-3">
                            <div className="space-y-2">
                              {(p.lines ?? []).map((ln, idx) => (
                                <div
                                  key={`${r.id}-line-${idx}`}
                                  className="flex items-center justify-between rounded border border-white/15 bg-black/35 px-3 py-2 text-[11px] text-emerald-100"
                                >
                                  <span>
                                    {ln.memo} · DR {moneyJson(ln.debit)} / CR{" "}
                                    {moneyJson(ln.credit)}
                                  </span>
                                  <button
                                    type="button"
                                    className="text-[10px] font-black uppercase text-cyan-300"
                                    onClick={() => void loadDrilldown(r.id, idx)}
                                  >
                                    Source orders
                                  </button>
                                </div>
                              ))}
                              {(p.lines ?? []).length === 0 ? (
                                <pre className="max-h-64 overflow-auto text-[10px] leading-relaxed text-emerald-100">
                                  {JSON.stringify(r.payload, null, 2)}
                                </pre>
                              ) : null}
                            </div>
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
            {staging.length === 0 ? (
              <p className="p-8 text-center text-sm text-app-text-muted">
                No staged journals. Propose one for a day with fulfilled sales.
              </p>
            ) : null}
          </div>

          <div className="overflow-hidden rounded-2xl border border-app-border bg-app-surface shadow-sm">
            <div className="border-b border-app-border bg-app-surface-2 px-4 py-2 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
              Sync history
            </div>
            <table className="w-full text-left text-xs">
              <thead className="bg-app-surface-2/60 text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                <tr>
                  <th className="px-4 py-2">Created</th>
                  <th className="px-4 py-2">Date</th>
                  <th className="px-4 py-2">Status</th>
                  <th className="px-4 py-2">QBO ID</th>
                  <th className="px-4 py-2">Approved by</th>
                  <th className="px-4 py-2">Fault detail</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-app-border">
                {staging.map((r) => (
                  <tr key={`history-${r.id}`}>
                    <td className="px-4 py-2 font-mono text-[11px]">
                      {new Date(r.created_at).toLocaleString()}
                    </td>
                    <td className="px-4 py-2 font-mono">{r.sync_date}</td>
                    <td className="px-4 py-2">{r.status}</td>
                    <td className="px-4 py-2 font-mono">{r.journal_entry_id ?? "—"}</td>
                    <td className="px-4 py-2 text-app-text-muted">
                      {accessLog.find(
                        (a) =>
                          a.event_kind === "qbo_staging_approve" &&
                          String(a.metadata?.staging_id ?? "") === r.id,
                      )?.staff_name ?? "—"}
                    </td>
                    <td className="px-4 py-2 text-red-700">{r.error_message ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {drilldown && (
        <div className="ui-overlay-backdrop justify-end">
          <div
            ref={drillDialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={drillTitleId}
            tabIndex={-1}
            className="ui-modal h-full max-w-md overflow-auto outline-none"
          >
            <div className="ui-modal-header flex items-center justify-between">
              <h3 id={drillTitleId} className="text-sm font-black uppercase tracking-widest text-app-text">
                Reconciliation drill-down
              </h3>
              <button
                type="button"
                className="ui-touch-target text-xs font-black uppercase text-app-text-muted"
                onClick={() => setDrilldown(null)}
              >
                Close
              </button>
            </div>
            <div className="ui-modal-body">
            <p className="mt-2 text-xs text-app-text-muted">
              {drilldown.memo} · line {drilldown.line_index + 1}
            </p>
            <div className="mt-4 space-y-2">
              {drilldown.contributors.map((c) => (
                <div
                  key={`${c.order_id}-${c.amount}`}
                  className="flex items-center justify-between rounded-lg border border-app-border px-3 py-2 text-xs"
                >
                  <span className="font-mono text-app-text">{c.order_id}</span>
                  <span className="font-semibold text-app-text">
                    {moneyJson(c.amount)}
                  </span>
                </div>
              ))}
              {drilldown.contributors.length === 0 ? (
                <p className="text-xs text-app-text-muted">No contributing orders found.</p>
              ) : null}
            </div>
            </div>
          </div>
        </div>
      )}

      {confirmAction && (
        <ConfirmationModal
          isOpen={true}
          title="Confirm Financial Action"
          message={confirmAction.label}
          confirmLabel="Execute"
          onConfirm={runConfirmedAction}
          onClose={() => setConfirmAction(null)}
          variant="info"
        />
      )}
    </div>
  );
}
